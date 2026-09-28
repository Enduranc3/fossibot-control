#!/usr/bin/env python3
"""Fossibot F1800 / F3000 -> Home Assistant bridge (MQTT Auto-Discovery).

The station has no BLE telemetry (BLE is only Wi-Fi provisioning), so two transports are offered,
the same ones the official app uses (see PROTOCOL.md):

  local  Run on a host joined to the station's FOSS_<SN> Wi-Fi. Listens on TCP :8058, the station
         connects to it. No cloud at all.
  cloud  Log in to app.fossibot.hk, telemetry over WebSocket, commands over HTTP. Works while the
         station is on your home Wi-Fi; the HA host only needs internet.

  pip install "paho-mqtt>=2" "websockets>=14"
  python3 ha_bridge.py local --mqtt-host 192.168.1.10 --sn F1800XXXXXXXX
  FOSSIBOT_PASSWORD=... python3 ha_bridge.py cloud --user me@example.com --sn F1800XXXXXXXX --mqtt-host ...
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass

import paho.mqtt.client as mqtt

log = logging.getLogger("fossibot")

# ------------------------------------------------------------------------------------ protocol

ACK_FRAME = bytes.fromhex("0a001f00040004001f00")
TYPE_REPORT, TYPE_WRITE, TYPE_ACK = 0x0B, 0x0C, 0x1F


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def build_write(key: int, value: int) -> bytes:
    """14-byte write frame; CRC over the 6-byte record only, high byte first."""
    v = max(0, min(0xFFFF, int(round(value))))
    record = bytes([key & 0xFF, key >> 8, v & 0xFF, v >> 8, 0, 0])
    crc = crc16_modbus(record)
    return bytes([0x0E, 0, 0x0C, 0, 0x08, 0]) + record + bytes([crc >> 8, crc & 0xFF])


@dataclass(frozen=True)
class Reg:
    key: int
    id: str
    type: str  # u8 bool i8 u16 i16 i32 u32 ver32
    scale: float = 1.0


REGISTERS = [
    Reg(1, "soc", "u8"), Reg(2, "battery_temp_max", "i8"), Reg(3, "remaining_minutes", "u16"),
    Reg(8, "pack_voltage", "u16", 0.1), Reg(9, "battery_current", "i32", 0.001),
    Reg(12, "bms_fault", "u32"), Reg(19, "ac_input_w", "u16"), Reg(20, "ac_output_w", "u16"),
    Reg(21, "ac_output_voltage", "u16", 0.1), Reg(22, "ac_output_frequency", "u16"),
    Reg(23, "solar_input_w", "u16"), Reg(24, "inverter_temp", "i16"), Reg(26, "pcs_fault", "u32"),
    Reg(27, "pv_voltage", "u16", 0.1), Reg(30, "pv_fault", "u32"), Reg(34, "total_input_w", "u16"),
    Reg(35, "total_output_w", "u16"), Reg(36, "dc_output_w", "u16"), Reg(37, "usb_output_w", "u16", 0.1),
    Reg(38, "led", "u8"), Reg(39, "ac_on", "bool"), Reg(40, "dc_on", "bool"), Reg(41, "usb_on", "bool"),
    Reg(42, "charge_power_w", "u16"), Reg(46, "eco_mode", "bool"), Reg(47, "firmware", "ver32"),
    Reg(48, "solar_energy_kwh", "u16"), Reg(49, "charge_limit", "u8"), Reg(50, "discharge_limit", "u8"),
]
BY_KEY = {r.key: r for r in REGISTERS}
KEY = {r.id: r.key for r in REGISTERS}


def decode(r: Reg, v: bytes):
    if r.type in ("u8", "bool"):
        n = v[0]
    elif r.type == "i8":
        n = v[0] - 256 if v[0] > 127 else v[0]
    elif r.type == "u16":
        n = v[0] | v[1] << 8
    elif r.type == "i16":
        n = int.from_bytes(v[:2], "little", signed=True)
    elif r.type == "i32":
        # The app treats a 0x0000/0xFFFF upper half as a sign-extended 16-bit value.
        if v[2:4] in (b"\x00\x00", b"\xff\xff"):
            n = int.from_bytes(v[:2], "little", signed=True)
        else:
            n = int.from_bytes(v[:4], "little", signed=True)
    elif r.type == "u32":
        n = int.from_bytes(v[:4], "little")
    else:  # ver32
        return "-".join(f"{b:02x}" for b in reversed(v[:4]))
    return round(n * r.scale, 3) if r.scale != 1.0 else n


def parse_frame(raw: bytes) -> dict | None:
    if len(raw) < 8:
        return None
    ftype = raw[2] | raw[3] << 8
    if ftype in (TYPE_ACK, TYPE_WRITE):
        return None
    out = {}
    off = 6
    while off + 6 <= len(raw) - 2:
        key = raw[off] | raw[off + 1] << 8
        if key in BY_KEY:
            out[BY_KEY[key].id] = decode(BY_KEY[key], raw[off + 2 : off + 6])
        off += 6
    return out


def _valid_header(buf: bytes, off: int) -> bool:
    if len(buf) - off < 6:
        return False
    ln = buf[off] | buf[off + 1] << 8
    return ln >= 8 and (buf[off + 4] | buf[off + 5] << 8) == ln - 6


def split_frames(buf: bytearray) -> list[bytes]:
    """Stream framing by LEN, falling back to 'whole chunk = one frame' like the original app."""
    frames = []
    while buf:
        if not _valid_header(buf, 0):
            if len(buf) < 6:
                break
            frames.append(bytes(buf))
            buf.clear()
            break
        ln = buf[0] | buf[1] << 8
        if len(buf) < ln:
            break
        rest = len(buf) - ln
        if rest == 0 or rest < 6 or _valid_header(buf, ln):
            frames.append(bytes(buf[:ln]))
            del buf[:ln]
        else:
            frames.append(bytes(buf))
            buf.clear()
            break
    return frames


# ------------------------------------------------------------------------------------ transports


class LocalTransport:
    """TCP server on :8058; the station connects to us (offline mode of the official app)."""

    def __init__(self, port: int, on_regs):
        self.port, self.on_regs = port, on_regs
        self.writer: asyncio.StreamWriter | None = None

    async def run(self):
        server = await asyncio.start_server(self._client, "0.0.0.0", self.port)
        log.info("listening on :%d, waiting for the station", self.port)
        async with server:
            await server.serve_forever()

    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        peer = writer.get_extra_info("peername")
        log.info("station connected from %s", peer)
        self.writer = writer
        buf = bytearray()
        try:
            while data := await reader.read(4096):
                log.debug("RX %s", data.hex(" "))
                buf += data
                for frame in split_frames(buf):
                    if regs := parse_frame(frame):
                        self.on_regs(regs)
                writer.write(ACK_FRAME)
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError) as e:
            log.warning("station connection error: %s", e)
        finally:
            log.info("station disconnected")
            if self.writer is writer:
                self.writer = None
            writer.close()

    async def send(self, frame: bytes):
        if not self.writer:
            raise RuntimeError("station is not connected")
        log.info("TX %s", frame.hex(" "))
        self.writer.write(frame)
        await self.writer.drain()


class CloudTransport:
    BASE = "http://app.fossibot.hk/prod-api/"
    WS = "ws://app.fossibot.hk/ws"

    def __init__(self, user: str, password: str, sn: str, on_regs):
        self.user, self.password, self.sn, self.on_regs = user, password, sn, on_regs
        self.token: str | None = None

    def _http(self, method: str, path: str, body: dict) -> dict:
        headers = {"lang": "en-US", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        url = self.BASE + path
        data = None
        if method == "GET":
            url += "?" + urllib.parse.urlencode(body)
        else:
            data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())

    async def login(self):
        res = await asyncio.to_thread(self._http, "POST", "app/user/login", {"username": self.user, "password": self.password})
        if res.get("code") != 200 or not res.get("token"):
            raise RuntimeError(f"login failed: {res.get('msg')}")
        self.token = res["token"]
        log.info("logged in to Fossibot cloud")

    async def run(self):
        import websockets

        delay = 2
        while True:
            try:
                if not self.token:
                    await self.login()
                headers = {"Authorization": f"Bearer {self.token}", "lang": "en-US", "snCode": self.sn}
                async with websockets.connect(self.WS, additional_headers=headers, open_timeout=15) as ws:
                    log.info("websocket connected")
                    delay = 2
                    hb = asyncio.create_task(self._heartbeat(ws))
                    try:
                        async for text in ws:
                            self._message(text)
                    finally:
                        hb.cancel()
            except Exception as e:  # noqa: BLE001 - reconnect on anything
                log.warning("cloud connection: %s; retry in %ds", e, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    async def _heartbeat(self, ws):
        while True:
            await asyncio.sleep(5)
            await ws.send(json.dumps({"type": "hear", "msg": self.user}))

    def _message(self, text):
        try:
            msg = json.loads(text)
        except ValueError:
            return
        code = str(msg.get("code", ""))
        if code == "401":
            self.token = None
            raise RuntimeError("401 from server, re-login")
        if code == "403":
            log.info("server: station offline")
            return
        data = msg.get("data")
        if isinstance(data, str) and (not msg.get("snCode") or msg["snCode"] == self.sn):
            try:
                frame = bytes.fromhex(data)
            except ValueError:
                return
            if regs := parse_frame(frame):
                self.on_regs(regs)

    async def send(self, frame: bytes):
        for attempt in (1, 2):
            res = await asyncio.to_thread(self._http, "GET", "app/ctrl/route", {"snCode": self.sn, "cmd": frame.hex()})
            if res.get("code") == 401 and attempt == 1:
                await self.login()
                continue
            if res.get("code") != 200:
                raise RuntimeError(f"command rejected: {res.get('msg')}")
            return


# ------------------------------------------------------------------------------------ MQTT / HA

LED_OPTIONS = ["Off", "On", "SOS", "Strobe"]
MODE_OPTIONS = ["UPS", "ECO"]

SENSORS = [
    # id, name, unit, device_class, state_class
    ("soc", "Battery", "%", "battery", "measurement"),
    ("total_input_w", "Input power", "W", "power", "measurement"),
    ("total_output_w", "Output power", "W", "power", "measurement"),
    ("ac_input_w", "AC input", "W", "power", "measurement"),
    ("ac_output_w", "AC output", "W", "power", "measurement"),
    ("solar_input_w", "Solar/DC input", "W", "power", "measurement"),
    ("dc_output_w", "DC output", "W", "power", "measurement"),
    ("usb_output_w", "USB output", "W", "power", "measurement"),
    ("remaining_minutes", "Remaining time", "min", "duration", "measurement"),
    ("ac_output_voltage", "AC voltage", "V", "voltage", "measurement"),
    ("ac_output_frequency", "AC frequency", "Hz", "frequency", "measurement"),
    ("pack_voltage", "Battery voltage", "V", "voltage", "measurement"),
    ("battery_current", "Battery current", "A", "current", "measurement"),
    ("battery_temp_max", "Battery temperature", "°C", "temperature", "measurement"),
    ("inverter_temp", "Inverter temperature", "°C", "temperature", "measurement"),
    ("pv_voltage", "PV voltage", "V", "voltage", "measurement"),
    ("solar_energy_kwh", "Solar energy", "kWh", "energy", "total_increasing"),
    ("bms_fault", "BMS fault code", None, None, None),
    ("pcs_fault", "PCS fault code", None, None, None),
    ("pv_fault", "PV fault code", None, None, None),
    ("firmware", "Firmware", None, None, None),
]
SWITCHES = [("ac_on", "AC output"), ("dc_on", "DC output"), ("usb_on", "USB output")]
NUMBERS = [
    ("charge_power_w", "Charge power", 100, 1200, 100, "W"),
    ("charge_limit", "Charge limit", 60, 100, 1, "%"),
    ("discharge_limit", "Discharge limit", 0, 20, 1, "%"),
]


class Bridge:
    def __init__(self, args):
        self.sn = args.sn
        self.base = f"fossibot/{self.sn}"
        self.loop: asyncio.AbstractEventLoop | None = None
        self.state: dict = {}
        self.last_seen = 0.0
        self.transport = (
            LocalTransport(args.port, self.on_regs)
            if args.mode == "local"
            else CloudTransport(args.user, args.password, self.sn, self.on_regs)
        )
        self.mqtt = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"fossibot-{self.sn}")
        if args.mqtt_user:
            self.mqtt.username_pw_set(args.mqtt_user, args.mqtt_password)
        self.mqtt.will_set(f"{self.base}/availability", "offline", retain=True)
        self.mqtt.on_connect = self._on_connect
        self.mqtt.on_message = self._on_message
        self.mqtt.connect_async(args.mqtt_host, args.mqtt_port)

    # --- HA discovery

    def _device(self):
        return {"identifiers": [f"fossibot_{self.sn}"], "name": f"Fossibot {self.sn}", "manufacturer": "Fossibot"}

    def _publish_discovery(self):
        avail = {"availability_topic": f"{self.base}/availability", "device": self._device()}
        uid = f"fossibot_{self.sn}"

        def pub(component, oid, cfg):
            self.mqtt.publish(f"homeassistant/{component}/{uid}/{oid}/config", json.dumps({**avail, **cfg}), retain=True)

        for sid, name, unit, dclass, sclass in SENSORS:
            cfg = {"name": name, "unique_id": f"{uid}_{sid}", "state_topic": f"{self.base}/state",
                   "value_template": f"{{{{ value_json.{sid} }}}}"}
            if unit: cfg["unit_of_measurement"] = unit
            if dclass: cfg["device_class"] = dclass
            if sclass: cfg["state_class"] = sclass
            if sid.endswith("_fault") or sid == "firmware": cfg["entity_category"] = "diagnostic"
            pub("sensor", sid, cfg)
        for sid, name in SWITCHES:
            pub("switch", sid, {"name": name, "unique_id": f"{uid}_{sid}", "state_topic": f"{self.base}/state",
                                "value_template": f"{{{{ 'ON' if value_json.{sid} == 1 else 'OFF' }}}}",
                                "command_topic": f"{self.base}/set/{sid}"})
        pub("select", "led", {"name": "LED light", "unique_id": f"{uid}_led", "options": LED_OPTIONS,
                              "state_topic": f"{self.base}/state", "command_topic": f"{self.base}/set/led",
                              "value_template": "{{ " + json.dumps(LED_OPTIONS) + "[value_json.led | int(0)] }}"})
        pub("select", "eco_mode", {"name": "Mode", "unique_id": f"{uid}_eco_mode", "options": MODE_OPTIONS,
                                   "state_topic": f"{self.base}/state", "command_topic": f"{self.base}/set/eco_mode",
                                   "value_template": "{{ 'ECO' if value_json.eco_mode == 1 else 'UPS' }}",
                                   "entity_category": "config"})
        for sid, name, lo, hi, step, unit in NUMBERS:
            pub("number", sid, {"name": name, "unique_id": f"{uid}_{sid}", "min": lo, "max": hi, "step": step,
                                "unit_of_measurement": unit, "state_topic": f"{self.base}/state",
                                "value_template": f"{{{{ value_json.{sid} }}}}",
                                "command_topic": f"{self.base}/set/{sid}", "entity_category": "config"})

    # --- MQTT callbacks (paho thread)

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        log.info("MQTT connected (%s)", reason_code)
        self._publish_discovery()
        client.subscribe(f"{self.base}/set/#")
        client.publish(f"{self.base}/availability", "online" if self.state else "offline", retain=True)

    def _on_message(self, client, userdata, msg):
        field = msg.topic.rsplit("/", 1)[-1]
        payload = msg.payload.decode().strip()
        try:
            if field in ("ac_on", "dc_on", "usb_on"):
                value = 1 if payload.upper() in ("ON", "1", "TRUE") else 0
            elif field == "led":
                value = LED_OPTIONS.index(payload) if payload in LED_OPTIONS else int(payload)
            elif field == "eco_mode":
                value = 1 if payload.upper() in ("ECO", "1") else 0
            else:
                value = int(float(payload))
            key = KEY[field]
        except (KeyError, ValueError):
            log.warning("ignored command %s=%s", msg.topic, payload)
            return
        asyncio.run_coroutine_threadsafe(self._send(key, value), self.loop)

    async def _send(self, key: int, value: int):
        try:
            await self.transport.send(build_write(key, value))
        except Exception as e:  # noqa: BLE001
            log.error("command key %d=%d failed: %s", key, value, e)

    # --- telemetry

    def on_regs(self, regs: dict):
        first = not self.state
        self.state.update(regs)
        self.last_seen = time.monotonic()
        self.mqtt.publish(f"{self.base}/state", json.dumps(self.state))
        if first:
            self.mqtt.publish(f"{self.base}/availability", "online", retain=True)

    async def _watchdog(self):
        while True:
            await asyncio.sleep(15)
            if self.state and time.monotonic() - self.last_seen > 90:
                self.mqtt.publish(f"{self.base}/availability", "offline", retain=True)
                self.state = {}

    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.mqtt.loop_start()
        try:
            await asyncio.gather(self.transport.run(), self._watchdog())
        finally:
            self.mqtt.publish(f"{self.base}/availability", "offline", retain=True)
            self.mqtt.loop_stop()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("mode", choices=["local", "cloud"])
    p.add_argument("--sn", required=True, help="station serial number (used for MQTT topics; required for cloud)")
    p.add_argument("--port", type=int, default=8058, help="local mode TCP port")
    p.add_argument("--user", help="Fossibot account email (cloud)")
    p.add_argument("--password", default=os.environ.get("FOSSIBOT_PASSWORD"), help="or env FOSSIBOT_PASSWORD")
    p.add_argument("--mqtt-host", default="localhost")
    p.add_argument("--mqtt-port", type=int, default=1883)
    p.add_argument("--mqtt-user", default=os.environ.get("MQTT_USER"))
    p.add_argument("--mqtt-password", default=os.environ.get("MQTT_PASSWORD"))
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()
    if args.mode == "cloud" and not (args.user and args.password):
        p.error("cloud mode needs --user and --password / FOSSIBOT_PASSWORD")
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    bridge = Bridge(args)
    loop = asyncio.new_event_loop()
    task = loop.create_task(bridge.run())
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, task.cancel)
    try:
        loop.run_until_complete(task)
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Fossibot station probe: checks whether the station talks to us on TCP :8058 and records
everything needed to finish the protocol (raw packets, LEN and CRC checks, decoded values).

No dependencies, Python 3.9+. On Android (Termux):
    pkg install python
    curl -LO https://raw.githubusercontent.com/Enduranc3/fossibot-control/main/tools/station_probe.py
    # connect the phone to the station's Wi-Fi FOSS_..., then:
    python station_probe.py

Commands while running (type and press Enter):
    led 0|1|2|3     LED off / on / SOS / strobe   (safe test)
    usb 0|1         USB output off / on
    ac 0|1, dc 0|1  AC / DC output off / on
    raw <hex>       send arbitrary bytes
    ack on|off      answer each packet with ACK like the official app (default: on)
    q               quit
Everything is also written to probe-<time>.log next to the script.
"""

import argparse
import datetime
import os
import socket
import sys
import threading
import time

ACK = bytes.fromhex("0a001f00040004001f00")

NAMES = {
    1: ("SoC", "%", 1), 2: ("Темп. батареї макс", "°C", 1), 3: ("Залишок часу", "хв", 1),
    4: ("Стан заряду", "", 1), 8: ("Напруга батареї", "V", 0.1), 9: ("Струм батареї", "mA", 1),
    12: ("Помилка BMS", "", 1), 19: ("AC вхід", "W", 1), 20: ("AC вихід", "W", 1),
    21: ("Напруга AC", "V", 0.1), 22: ("Частота AC", "Hz", 0.1), 23: ("Сонце/DC вхід", "W", 1),
    26: ("Помилка PCS", "", 1), 30: ("Помилка PV", "", 1), 34: ("Загальний вхід", "W", 1),
    35: ("Загальний вихід", "W", 1), 36: ("DC вихід", "W", 1), 37: ("USB вихід", "W", 0.1),
    38: ("LED", "", 1), 39: ("AC", "", 1), 40: ("DC", "", 1), 41: ("USB", "", 1),
    42: ("Потужність заряду", "W", 1), 46: ("ECO", "", 1), 49: ("Ліміт заряду", "%", 1),
    50: ("Ліміт розряду", "%", 1),
}
KEYS = {"led": 38, "ac": 39, "dc": 40, "usb": 41}

log_file = None
log_lock = threading.Lock()


def log(msg=""):
    line = f"{datetime.datetime.now():%H:%M:%S.%f}"[:-3] + "  " + msg
    with log_lock:
        print(line, flush=True)
        if log_file:
            log_file.write(line + "\n")
            log_file.flush()


def crc16_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def build_write(key, value):
    record = bytes([key & 0xFF, key >> 8, value & 0xFF, (value >> 8) & 0xFF, 0, 0])
    crc = crc16_modbus(record)
    return bytes([0x0E, 0, 0x0C, 0, 0x08, 0]) + record + bytes([crc >> 8, crc & 0xFF])


def hexs(b):
    return b.hex(" ").upper()


def analyze(raw):
    """Prints header/LEN/CRC checks and decoded records for one received chunk."""
    n = len(raw)
    if n < 8:
        log(f"   короткий пакет ({n} байт)")
        return
    ln, typ, plen = raw[0] | raw[1] << 8, raw[2] | raw[3] << 8, raw[4] | raw[5] << 8
    log(f"   заголовок: LEN={ln} TYPE=0x{typ:04X} PLEN={plen}; фактично {n} байт; "
        f"LEN==розмір: {'так' if ln == n else 'НІ'}; PLEN==LEN-6: {'так' if plen == ln - 6 else 'НІ'}")
    tail = raw[-2:]
    found = []
    for name, start in (("records(6..-2)", 6), ("all(0..-2)", 0), ("from2", 2), ("from4", 4)):
        c = crc16_modbus(raw[start:-2])
        if tail == bytes([c >> 8, c & 0xFF]):
            found.append(f"{name} big-endian")
        if tail == bytes([c & 0xFF, c >> 8]):
            found.append(f"{name} little-endian")
    log(f"   CRC {hexs(tail)}: " + (", ".join(found) if found else "не збігся з жодним варіантом"))
    off, vals = 6, []
    while off + 6 <= n - 2:
        key = raw[off] | raw[off + 1] << 8
        v = raw[off + 2:off + 6]
        u16 = v[0] | v[1] << 8
        if key in NAMES:
            name, unit, scale = NAMES[key]
            val = v[0] if key in (1, 4, 38, 39, 40, 41, 46, 49, 50) else u16
            if key == 2:
                val = v[0] - 256 if v[0] > 127 else v[0]
            shown = round(val * scale, 1) if scale != 1 else val
            vals.append(f"{name}={shown}{unit}")
        else:
            vals.append(f"#{key}={v.hex()}")
        off += 6
    if vals:
        log("   " + "; ".join(vals))


class Probe:
    def __init__(self, port, ack):
        self.port, self.ack = port, ack
        self.conn = None
        self.packets = 0

    def serve(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("0.0.0.0", self.port))
        srv.listen(4)
        log(f"Слухаю TCP :{self.port}. Чекаю, поки станція підключиться…")
        threading.Thread(target=self.udp_listen, daemon=True).start()
        threading.Thread(target=self.reminder, daemon=True).start()
        while True:
            conn, addr = srv.accept()
            log(f"*** СТАНЦІЯ ПІДКЛЮЧИЛАСЬ з {addr[0]}:{addr[1]} ***")
            self.conn = conn
            threading.Thread(target=self.read, args=(conn, addr), daemon=True).start()

    def read(self, conn, addr):
        try:
            while True:
                data = conn.recv(4096)
                if not data:
                    break
                self.packets += 1
                log(f"RX #{self.packets} ({len(data)} байт): {hexs(data)}")
                analyze(data)
                if self.ack:
                    conn.sendall(ACK)
                    log(f"TX ACK: {hexs(ACK)}")
        except OSError as e:
            log(f"помилка з'єднання: {e}")
        finally:
            log(f"*** станція {addr[0]} відключилась ***")
            if self.conn is conn:
                self.conn = None
            conn.close()

    def udp_listen(self):
        # In case the station looks for the phone with a UDP broadcast first.
        try:
            u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            u.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            u.bind(("0.0.0.0", self.port))
            while True:
                data, addr = u.recvfrom(2048)
                log(f"UDP від {addr[0]}:{addr[1]}: {hexs(data)}")
        except OSError as e:
            log(f"(UDP :{self.port} недоступний: {e})")

    def reminder(self):
        time.sleep(60)
        if not self.packets and not self.conn:
            log("За хвилину станція не підключилась. Перевірте: телефон у Wi-Fi FOSS_…, "
                "Android не відключився від мережі «без інтернету», IP телефона вище — з мережі станції.")
            log("Спробуйте вимкнути/увімкнути Wi-Fi на станції або перепідключити телефон до FOSS_…")

    def send(self, data, label):
        if not self.conn:
            log("станція не підключена — нема куди відправити")
            return
        self.conn.sendall(data)
        log(f"TX {label}: {hexs(data)}")


def local_ips():
    ips = set()
    for target in ("192.168.4.1", "10.10.10.1", "8.8.8.8"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((target, 80))
            ips.add(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    ips.discard("127.0.0.1")
    return sorted(ips)


def console(probe):
    for line in sys.stdin:
        parts = line.strip().split()
        if not parts:
            continue
        cmd = parts[0].lower()
        try:
            if cmd == "q":
                log("вихід")
                os._exit(0)
            elif cmd in KEYS and len(parts) == 2:
                probe.send(build_write(KEYS[cmd], int(parts[1])), f"{cmd}={parts[1]}")
            elif cmd == "raw" and len(parts) >= 2:
                probe.send(bytes.fromhex("".join(parts[1:])), "raw")
            elif cmd == "ack" and len(parts) == 2:
                probe.ack = parts[1] == "on"
                log(f"ACK {'увімкнено' if probe.ack else 'вимкнено'}")
            else:
                log("команди: led 0-3 | usb 0/1 | ac 0/1 | dc 0/1 | raw <hex> | ack on/off | q")
        except ValueError as e:
            log(f"помилка: {e}")


def main():
    global log_file
    p = argparse.ArgumentParser(description="Fossibot station probe")
    p.add_argument("--port", type=int, default=8058)
    p.add_argument("--no-ack", action="store_true", help="do not answer packets with ACK")
    args = p.parse_args()

    name = f"probe-{datetime.datetime.now():%Y%m%d-%H%M%S}.log"
    log_file = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name), "w", encoding="utf-8")
    log(f"Fossibot probe; лог: {name}")
    log(f"IP цього пристрою: {', '.join(local_ips()) or 'не визначено'}")
    log("Команди: led 0-3 | usb 0/1 | ac 0/1 | dc 0/1 | raw <hex> | ack on/off | q")

    probe = Probe(args.port, ack=not args.no_ack)
    threading.Thread(target=console, args=(probe,), daemon=True).start()
    try:
        probe.serve()
    except KeyboardInterrupt:
        log("вихід")
    except OSError as e:
        log(f"Не вдалося відкрити порт {args.port}: {e}")


if __name__ == "__main__":
    main()

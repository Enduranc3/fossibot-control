#!/data/data/com.termux/files/usr/bin/sh
# Installs an unpacked fossibot-hub release in Termux: release dir, `current` link, runit service with
# rotated logs, Termux:Boot start-up and the fossibot-update / fossibot-passwd commands.
# usage: sh install.sh <unpacked release dir>   (FOSSIBOT_ORIGINS=https://… on the first install)
set -eu
REL=$(cd "${1:?usage: install.sh <release dir>}" && pwd)
PREFIX=${PREFIX:-/data/data/com.termux/files/usr}
BASE=${FOSSIBOT_BASE:-$HOME/fossibot-hub}
DATA=${FOSSIBOT_DATA_DIR:-$HOME/.fossibot}
VER=$(cat "$REL/VERSION")

mkdir -p "$BASE/releases" "$DATA"
TARGET="$BASE/releases/$VER"
if [ "$REL" != "$TARGET" ]; then
  rm -rf "$TARGET"
  cp -R "$REL" "$TARGET"
fi
ln -sfn "$TARGET" "$BASE/current"

# A new file and a rename: fossibot-update may be the script running this install right now.
for cmd in fossibot-update fossibot-passwd; do
  cp "$TARGET/deploy/termux/$cmd" "$PREFIX/bin/$cmd.tmp"
  chmod 755 "$PREFIX/bin/$cmd.tmp"
  mv -f "$PREFIX/bin/$cmd.tmp" "$PREFIX/bin/$cmd"
done

SVC="$PREFIX/var/service/fossibot-hub"
mkdir -p "$SVC/log" "$PREFIX/var/log/sv/fossibot-hub"
cat > "$SVC/run" <<EOF
#!$PREFIX/bin/sh
[ -f "$DATA/hub.env" ] && . "$DATA/hub.env"
export FOSSIBOT_DATA_DIR="$DATA"
exec $PREFIX/bin/node $BASE/current/hub/hub.mjs 2>&1
EOF
chmod 755 "$SVC/run"
ln -sfn "$PREFIX/share/termux-services/svlogger" "$SVC/log/run"
# svlogd: rotate at 10 MB, keep 5 files (spec §10).
printf 's10485760\nn5\n' > "$PREFIX/var/log/sv/fossibot-hub/config"

if [ ! -f "$DATA/hub.env" ]; then
  printf "export FOSSIBOT_ORIGINS='%s'\n" "${FOSSIBOT_ORIGINS:-}" > "$DATA/hub.env"
fi

mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-services" <<EOF
#!$PREFIX/bin/sh
# Termux:Boot: keep the CPU awake and start runit services (fossibot-hub, tailscaled, sshd).
termux-wake-lock
. $PREFIX/etc/profile.d/start-services.sh
EOF
chmod 755 "$HOME/.termux/boot/start-services"

echo "fossibot-hub $VER installed in $TARGET"

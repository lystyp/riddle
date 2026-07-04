#!/bin/bash
# Launch the diary in full-takeover mode: stop xochitl, run riddle against the
# vendor e-ink engine (instant ink), ALWAYS restore xochitl on exit.
#
# Exit the diary: power button, 5-finger tap, or SIGTERM. Escape hatch if
# anything wedges: ssh rm 'systemctl start xochitl'.

restore() {
    rm -f /tmp/epframebuffer.lock
    systemctl start xochitl
}
trap restore EXIT INT TERM

systemctl stop xochitl
rm -f /tmp/epframebuffer.lock      # stale EPD lock blocks the engine
sleep 1

cd /home/root/riddle
# libquill.so is beside the quill install; qsgepaper from the scenegraph dir.
LD_LIBRARY_PATH=/home/root/quill:/usr/lib/plugins/scenegraph \
    PAPERTERM_SHELL= HOME=/home/root \
    /home/root/riddle/riddle
echo "riddle-takeover: diary closed ($?), restoring xochitl"

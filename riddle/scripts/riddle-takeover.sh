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

# Oracle config: put your API key in /home/root/riddle/oracle.env, e.g.
#   RIDDLE_OPENAI_KEY=sk-...
#   RIDDLE_OPENAI_BASE=https://api.openai.com/v1     # optional
#   RIDDLE_OPENAI_MODEL=gpt-4o-mini                  # optional
# Without it, riddle falls back to the pi backend (if pi is installed).
if [ -f /home/root/riddle/oracle.env ]; then
    set -a; . /home/root/riddle/oracle.env; set +a
fi

systemctl stop xochitl
rm -f /tmp/epframebuffer.lock      # stale EPD lock blocks the engine
sleep 1

cd /home/root/riddle
# libquill.so is beside the quill install; qsgepaper from the scenegraph dir.
LD_LIBRARY_PATH=/home/root/quill:/usr/lib/plugins/scenegraph \
    PAPERTERM_SHELL= HOME=/home/root \
    /home/root/riddle/riddle
echo "riddle-takeover: diary closed ($?), restoring xochitl"

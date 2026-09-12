#!/bin/sh
# Registers the .papf mime type so file managers pick up the PDF thumbnailer.
if command -v update-mime-database >/dev/null 2>&1; then
	update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi

PYTHON ?= $(HOME)/.config/dmg/python/bin/python3
LIVE := tests/live/test_streaming_recorder.sh tests/live/test_dictation_e2e.sh tests/live/test_reconnect.sh

.PHONY: test test-quick test-live

# The server, with pytest. Needs no Hammerspoon.
test:
	cd tests/python && $(PYTHON) -m pytest -q -p no:cacheprovider

# The same, without the test that plays the 43.5 s fixture in real time.
test-quick:
	cd tests/python && $(PYTHON) -m pytest -q -p no:cacheprovider -m "not slow"

# The Spoon, in the running Hammerspoon 2. test_reconnect.sh reloads the configuration and
# restarts the real server.
test-live:
	@failed=0; for script in $(LIVE); do echo "# $$script"; bash $$script || failed=1; done; exit $$failed

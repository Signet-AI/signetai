import os
import socket

_original_connect = socket.socket.connect

def _guarded_connect(self, address):
    if isinstance(address, tuple) and len(address) > 1 and address[1] == 3850:
        journal = os.environ.get("SIGNET_TEST_BLOCKED_FETCHES")
        if journal:
            with open(journal, "a", encoding="utf8") as stream:
                stream.write("Blocked Python test connection to port 3850\n")
        raise RuntimeError("Tests must never connect to the live daemon on port 3850")
    return _original_connect(self, address)

socket.socket.connect = _guarded_connect

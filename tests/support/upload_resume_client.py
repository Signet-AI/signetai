import json
import os
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"integrations/hermes-agent/connector/hermes-plugin"))
from signet_transport import ConnectorRegistry,NodeTransport,resolve_target,write_key_file
config=json.loads(Path(sys.argv[1]).read_text())
key_file=write_key_file(config["url"],"codex",config["key"])
ConnectorRegistry().set("codex",{"url":config["url"],"keyFile":str(key_file),"agentId":config["agentId"]})
transport=NodeTransport(resolve_target(harness="codex"),timeout=60,retries=0)
if sys.argv[2] == "resume":
    result=transport.flush(force=True,timeout=60)
    if config.get("retained"):
        if result["state"] != "failed" or result["pending"] != 1 or result["sent"] != 0:
            raise RuntimeError("Rejected source evidence was not retained")
    elif result["state"] != "complete" or result["sent"] != 1:
        raise RuntimeError("Resumed delivery did not complete: "+json.dumps(result))
else:
    transport.request("POST","/api/hooks/session-end",{"harness":"codex","agentId":config["agentId"],"sessionKey":"a21-resume-conformance","reason":"session_shutdown","transcriptPath":config["source"],"transcript":""})

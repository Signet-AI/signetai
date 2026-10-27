#!/usr/bin/env python3
"""Minimal RunPod GraphQL client. RUNPOD_API_KEY comes from the environment
(inject with `signet secret exec`; see rpx.sh). Never prints the key."""
import json, os, sys, urllib.request

URL = "https://api.runpod.io/graphql"
WATCH = ("H200", "B200", "B300", "H100", "PRO 6000", "L40S")


def gql(query, variables=None, fatal=True):
    req = urllib.request.Request(URL, data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['RUNPOD_API_KEY']}", "User-Agent": "signet-bench/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if d.get("errors"):
        if fatal:
            raise SystemExit("ERROR " + "; ".join(e.get("message", "") for e in d["errors"]))
        return {"errors": [e.get("message", "") for e in d["errors"]]}
    return d["data"]


POD_FIELDS = "id name desiredStatus costPerHr imageName machine { podHostId gpuDisplayName location } runtime { uptimeInSeconds }"


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "me":
        d = gql("{ myself { clientBalance currentSpendPerHr pods { id name desiredStatus costPerHr machine { gpuDisplayName } } } }")["myself"]
        print(json.dumps(d, indent=1))
    elif cmd == "gpus":
        q = """{ gpuTypes { id displayName memoryInGb securePrice communityPrice
                 lowestPrice(input:{gpuCount:1}) { uninterruptablePrice stockStatus } } }"""
        for g in gql(q)["gpuTypes"]:
            if any(w in g["displayName"] for w in WATCH):
                lp = g.get("lowestPrice") or {}
                print(f"{g['id']:34s} {g['memoryInGb']:>4}GB secure ${g['securePrice']} community ${g['communityPrice']} stock {lp.get('stockStatus')}")
    elif cmd == "create":
        spec = json.load(open(args[0]))
        q = f"mutation($input: PodFindAndDeployOnDemandInput) {{ podFindAndDeployOnDemand(input: $input) {{ {POD_FIELDS} }} }}"
        d = gql(q, {"input": spec}, fatal=False)
        print(json.dumps(d.get("podFindAndDeployOnDemand") if "errors" not in d else d))
    elif cmd == "pod":
        print(json.dumps(gql(f"query($id:String!){{ pod(input:{{podId:$id}}) {{ {POD_FIELDS} }} }}", {"id": args[0]})["pod"]))
    elif cmd == "start":
        d = gql("mutation($id:String!){ podResume(input:{podId:$id, gpuCount:1}) { id desiredStatus costPerHr } }", {"id": args[0]}, fatal=False)
        print(json.dumps(d))
    elif cmd == "stop":
        print(json.dumps(gql("mutation($id:String!){ podStop(input:{podId:$id}) { id desiredStatus } }", {"id": args[0]})))
    elif cmd == "terminate":
        print(json.dumps(gql("mutation($id:String!){ podTerminate(input:{podId:$id}) }", {"id": args[0]})))
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()

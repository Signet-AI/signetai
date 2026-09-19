#!/usr/bin/env bun

import { installService, uninstallService } from "../platform/daemon/src/service";

const action = process.argv[2];
if (action === "install") await installService();
else if (action === "uninstall") await uninstallService();
else throw new Error("Usage: bun scripts/native-daemon-service.ts <install|uninstall>");

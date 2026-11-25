#!/usr/bin/env node

import { z } from "zod";
import { runMcpStdio } from "./stdio-runtime.js";
void z.object({});

await runMcpStdio();

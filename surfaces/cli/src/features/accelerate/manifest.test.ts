import { expect, it } from "bun:test";
import { posix } from "node:path";
import { CUDA_LIBRARIES } from "./manifest.js";

const CUDNN_WHEEL_URL =
	"https://files.pythonhosted.org/packages/65/e4/c5a205d48ff00ed8b27882bb45d338d8138e976c76385f328a326bbfaeda/nvidia_cudnn_cu12-9.27.0.42-py3-none-manylinux_2_27_x86_64.whl";
const CUDNN_WHEEL_RECORD = `nvidia/cudnn/lib/libcudnn.so.9,sha256=TDzLVS7gxDqsynSY4SkU-9oxvk_LUsvcGqqH54-5bhk,133336
nvidia/cudnn/lib/libcudnn_adv.so.9,sha256=b7L3RV5pDXffM1FIO-Or0jx7JshcsrcP5iq9J8ChT6I,274846904
nvidia/cudnn/lib/libcudnn_cnn.so.9,sha256=C8FQ7k1u1Ukoel4sBPMoQVWyCKIghFQ7avLsZSHgJWE,4203880
nvidia/cudnn/lib/libcudnn_engines_precompiled.so.9,sha256=EGFx1QrbU8Jjyc6Og9OyV_4jFzE3Lbty0xUg-lj659E,566255968
nvidia/cudnn/lib/libcudnn_engines_runtime_compiled.so.9,sha256=P0gOeKYasW1UJjwDl_YvV5Fa9nITdSuOcjXnT0sCejY,48269728
nvidia/cudnn/lib/libcudnn_engines_tensor_ir.so.9,sha256=gF7Ab3VJRMEHzk4sI0o6GQqOQtW0v66CqRKEYP1ZWb0,2099128
nvidia/cudnn/lib/libcudnn_ext.so.9,sha256=-39G6qrdLIG9pYUEcmBY-ku752y8hwc8JxUTFS8Kud0,8401752
nvidia/cudnn/lib/libcudnn_graph.so.9,sha256=KKqg3Jk8kdfFN4RtNAmkXdcblAl8R5Su35qsipigusg,115562616
nvidia/cudnn/lib/libcudnn_heuristic.so.9,sha256=D4vr0_BBvc4Q4Rx5gfPNOX6Q4flTIVtq-hw3sdZdsVo,96473880
nvidia/cudnn/lib/libcudnn_ops.so.9,sha256=5sMkLo6oH9ybM9aiAUTKt7okbSpLtrntMfCJS-VZIeQ,106964664`;

it("pins the complete cuDNN 9.27.0.42 Linux x64 runtime payload from NVIDIA's wheel RECORD", () => {
	const cudnn = CUDA_LIBRARIES["linux-x64"]?.find((zip) => zip.url === CUDNN_WHEEL_URL);
	expect(cudnn).toBeDefined();
	const expected = CUDNN_WHEEL_RECORD.split("\n").map((line) => {
		const [path, digest, size] = line.split(",");
		return {
			path,
			name: posix.basename(path),
			sha256: Buffer.from(digest.slice("sha256=".length), "base64url").toString("hex"),
			size: Number(size),
		};
	});
	const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
	expect([...(cudnn?.members ?? [])].sort(byPath)).toEqual(expected.sort(byPath));
});

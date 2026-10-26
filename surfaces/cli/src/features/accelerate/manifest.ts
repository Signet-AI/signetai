export const ONNXRUNTIME_NODE_VERSION = "1.24.3";

export interface PinnedFile {
	readonly name: string;
	readonly sha256: string;
	readonly size: number;
}

export interface PinnedZipMember extends PinnedFile {
	readonly path: string;
}

export interface PinnedZip {
	readonly label: string;
	readonly url: string;
	readonly members: readonly PinnedZipMember[];
}

export const ONNXRUNTIME_NODE_TARBALL = {
	url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNXRUNTIME_NODE_VERSION}.tgz`,
	integrity: "sha512-JH7+czbc8ALA819vlTgcV+Q214/+VjGeBHDjX81+ZCD0PCVCIFGFNtT0V4sXG/1JXypKPgScQcB3ij/hk3YnTg==",
} as const;

export const ONNXRUNTIME_PLATFORM_FILES: Readonly<Record<string, readonly string[]>> = {
	"linux-x64": ["onnxruntime_binding.node", "libonnxruntime.so.1"],
	"linux-arm64": ["onnxruntime_binding.node", "libonnxruntime.so.1"],
	"darwin-arm64": ["onnxruntime_binding.node", `libonnxruntime.${ONNXRUNTIME_NODE_VERSION}.dylib`],
	"win32-x64": ["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"],
	"win32-arm64": ["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"],
};

export const CUDA_MIN_DRIVER_MAJOR = 525;

export const CUDA_PROVIDER: Readonly<Record<string, PinnedZip>> = {
	"linux-x64": {
		label: "ONNX Runtime CUDA provider",
		url: `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.gpu.linux/${ONNXRUNTIME_NODE_VERSION}/microsoft.ml.onnxruntime.gpu.linux.${ONNXRUNTIME_NODE_VERSION}.nupkg`,
		members: [
			{
				path: "runtimes/linux-x64/native/libonnxruntime_providers_cuda.so",
				name: "libonnxruntime_providers_cuda.so",
				sha256: "3ca573cfc14f7b8efa8e4b987851d8958b22228a4a15be1e2609a81cfb641974",
				size: 315724552,
			},
			{
				path: "runtimes/linux-x64/native/libonnxruntime_providers_shared.so",
				name: "libonnxruntime_providers_shared.so",
				sha256: "c6a12593396095f5670160e284c35d1700b7708cf3037b7042e2a5200ccae772",
				size: 14632,
			},
		],
	},
};

const PYPI = "https://files.pythonhosted.org/packages";

export const CUDA_LIBRARIES: Readonly<Record<string, readonly PinnedZip[]>> = {
	"linux-x64": [
		{
			label: "CUDA runtime 12.9",
			url: `${PYPI}/bc/46/a92db19b8309581092a3add7e6fceb4c301a3fd233969856a8cbf042cd3c/nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`,
			members: [
				{
					path: "nvidia/cuda_runtime/lib/libcudart.so.12",
					name: "libcudart.so.12",
					sha256: "256e6409e4f06f618e1fb53d4844a6b81cdded1013afa8ade40c22f99eb133b7",
					size: 741088,
				},
			],
		},
		{
			label: "cuBLAS 12.9",
			url: `${PYPI}/cb/c0/0a517bfe63ccd3b92eb254d264e28fca3c7cab75d07daea315250fb1bf73/nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl`,
			members: [
				{
					path: "nvidia/cublas/lib/libcublas.so.12",
					name: "libcublas.so.12",
					sha256: "5757ab5839fb4f203ca47ecb336110d10f4a5606b1e097f195fbca89774569e2",
					size: 105140976,
				},
				{
					path: "nvidia/cublas/lib/libcublasLt.so.12",
					name: "libcublasLt.so.12",
					sha256: "2c9006a75c74b3bea2dc7ae2ec38ab038b0e45ea02cb4b717a915e8a5796acb1",
					size: 749210000,
				},
			],
		},
		{
			label: "cuFFT 11.4",
			url: `${PYPI}/95/f4/61e6996dd20481ee834f57a8e9dca28b1869366a135e0d42e2aa8493bdd4/nvidia_cufft_cu12-11.4.1.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`,
			members: [
				{
					path: "nvidia/cufft/lib/libcufft.so.11",
					name: "libcufft.so.11",
					sha256: "e1d65ebd08895f9d9883f848f3974f89e0130416252477b18835ba7f15d159bc",
					size: 291507928,
				},
			],
		},
		{
			label: "cuRAND 10.3",
			url: `${PYPI}/31/44/193a0e171750ca9f8320626e8a1f2381e4077a65e69e2fb9708bd479e34a/nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl`,
			members: [
				{
					path: "nvidia/curand/lib/libcurand.so.10",
					name: "libcurand.so.10",
					sha256: "ab8c07338fa663c018b16df5b3f3878c84aaae98bda930e9e8bad340427b0faa",
					size: 166965432,
				},
			],
		},
		{
			label: "cuDNN 9 loader",
			url: `${PYPI}/65/e4/c5a205d48ff00ed8b27882bb45d338d8138e976c76385f328a326bbfaeda/nvidia_cudnn_cu12-9.27.0.42-py3-none-manylinux_2_27_x86_64.whl`,
			members: [
				{
					path: "nvidia/cudnn/lib/libcudnn.so.9",
					name: "libcudnn.so.9",
					sha256: "4c3ccb552ee0c43aacca7498e12914fbda31be4fcb52cbdc1aaa87e78fb96e19",
					size: 133336,
				},
			],
		},
	],
};

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	return `${platform}-${arch}`;
}

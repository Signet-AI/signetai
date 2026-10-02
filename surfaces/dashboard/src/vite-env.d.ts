/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_ONBOARDING_PREVIEW: boolean;
}

declare module "*.obj?raw" {
	const content: string;
	export default content;
}

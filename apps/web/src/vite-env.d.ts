/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_SPLASH?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

declare const __MINERADIO_BUILD_COMMIT__: string;

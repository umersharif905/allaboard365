/// <reference types="vite/client" />

// Declare process.env for browser context (Vite replaces these at build time)
declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV: 'development' | 'production' | 'test';
  }
}

declare const process: {
  env: NodeJS.ProcessEnv;
};
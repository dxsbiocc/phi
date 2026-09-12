// Re-export shim: the actual domain types live in src/shared/wrapperTypes.ts
// so the renderer (which cannot import from src/main — see tsconfig.web.json)
// can share them too, e.g. for the react-flow workflow diagram. Keep
// importing from './types' within src/main/agent/wrappers/* — this file
// exists so none of those import paths needed to change.
export * from '../../../shared/wrapperTypes'

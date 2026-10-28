import { defineProgram } from "nukadoko";

// The steps run dist/cli.js, which git ignores, so each tree a run makes
// (the base and the old world of `nuka run --base`) builds its own.
export default defineProgram({
  build: ["npm run build"],
});

// The express4 devDependency is an npm alias for express 4; the express 5
// types are close enough for the API surface the tests use.
declare module "express4" {
  import express from "express";
  export = express;
}

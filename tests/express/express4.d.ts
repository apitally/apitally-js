// The `express4` dependency aliases Express 4; Express 5's declarations cover
// the API surface used by these tests.
declare module "express4" {
  import express from "express";
  export = express;
}

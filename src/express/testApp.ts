import { Joi, Segments, celebrate, errors } from "celebrate";
import express from "express";
import { join } from "path";
import { useApitally } from "./middleware";

const app = express();
const port = 3001;

useApitally(app, {
  clientId: "fa4f144d-33be-4694-95e4-f5c18b0f151d",
  env: "default",
});

app.get("/", (req, res) => res.send("Hello world!"));
app.get(
  "/hello",
  celebrate(
    {
      [Segments.QUERY]: {
        name: Joi.string().required().max(5),
        age: Joi.number().required().min(18),
      },
    },
    { abortEarly: false }
  ),
  (req, res) => {
    return res.send(`Hello ${req.query?.name}!`);
  }
);
app.get("/hello/:id(\\d+)", (req, res) => res.send(`Hello ${req.params.id}!`));
app.use(errors());

app.listen(port, () => console.log(`Server running on port ${port}`));

import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./library.css";
import "./photo-intake.css";
import "./authoring.css";
import "./providers.css";
import "./jobs.css";
import "./responsive.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

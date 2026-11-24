import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Checkout } from "./Checkout";
import { parseCheckoutLink } from "./link";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");

const link = parseCheckoutLink(window.location);

createRoot(root).render(
  <StrictMode>
    {link ? (
      <Checkout paymentId={link.paymentId} clientSecret={link.clientSecret} />
    ) : (
      <main className="card">
        <p className="notice error" role="alert">
          This payment link is incomplete. Ask the shop for a new one.
        </p>
      </main>
    )}
  </StrictMode>,
);

import { useEffect, useState } from "react";
import Arena from "./components/Arena";
import AdminPanel from "./components/AdminPanel";

/**
 * Routing.
 *
 * This app has exactly two screens, so it uses the pathname directly rather
 * than a routing library. That is a deliberate choice: a router is a
 * dependency, a bundle cost and a version to keep current, and here it would
 * be resolving a choice between two options.
 *
 * IF YOUR REPO ALREADY HAS A ROUTER (react-router, TanStack Router, ...):
 * delete this file and mount the two components in your existing route tree
 * instead. They take no props and know nothing about how they were reached:
 *
 *     "/"       ->  <Arena />
 *     "/admin"  ->  <AdminPanel />
 *
 * Either way `vercel.json` must rewrite unknown paths to /index.html, or a
 * hard refresh on /admin returns a 404 from Vercel before React ever runs.
 */
export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  // Keep the view in step with the back and forward buttons.
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const isAdmin = path.replace(/\/+$/, "").toLowerCase() === "/admin";

  return isAdmin ? <AdminPanel /> : <Arena />;
}

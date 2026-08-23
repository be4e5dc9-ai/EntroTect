import { createRoot } from "react-dom/client";

function App(): React.JSX.Element {
  return <div>EntroTect</div>;
}

createRoot(document.getElementById("root")!).render(<App />);

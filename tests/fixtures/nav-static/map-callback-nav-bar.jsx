// Regression fixture: the persistent-nav-bar shape a consumer (storyline) hit.
// A local closure, called imperatively via `.map()`, reads a literal property
// off a parameter bound to a same-file array of object literals. Before the fix
// the target was opaque (or a phantom `destination.screen` under react-router)
// AND the closure had no containment parent, so the `AppNav` anchor never
// attributed. Read by tests/nav-extract.test.mjs + tests/nav-model.test.mjs.
import { useNavigate } from 'react-router-dom';

const DESTINATIONS = [
  { screen: 'workflow', label: 'Workflow' },
  { screen: 'library', label: 'Library' },
  { screen: 'settings', label: 'Settings' },
];

function AppNav() {
  const navigate = useNavigate();
  const renderDestination = (destination) => (
    <li key={destination.screen}>
      <button onClick={() => navigate(destination.screen)}>
        {destination.label}
      </button>
    </li>
  );
  return <nav><ul>{DESTINATIONS.map(renderDestination)}</ul></nav>;
}

export default function App() {
  return <AppNav />;
}

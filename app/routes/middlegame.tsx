import { PhasePage } from "./phase";

export { clientLoader } from "./phase";

export function meta() {
  return [
    { title: "Middlegame · Forma" },
    {
      name: "description",
      content: "Your middlegame mistakes, grouped by the idea you missed.",
    },
  ];
}

export default function Middlegame() {
  return <PhasePage phase="middlegame" />;
}

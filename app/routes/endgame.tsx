import { PhasePage } from "./phase";

export { clientLoader } from "./phase";

export function meta() {
  return [
    { title: "Endgame · Forma" },
    {
      name: "description",
      content: "The endgames you reach, and what you do with them.",
    },
  ];
}

export default function Endgame() {
  return <PhasePage phase="endgame" />;
}

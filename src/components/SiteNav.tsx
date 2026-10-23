import { Link } from "@tanstack/react-router";
import { Leaf } from "lucide-react";

const links = [
  { to: "/", label: "Simulator" },
  { to: "/live", label: "Live run" },
  { to: "/pitch", label: "Pitch" },
] as const;

export function SiteNav() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Leaf className="size-4" />
          </span>
          GreenOps<span className="text-muted-foreground font-normal">/orchestrator</span>
        </Link>
        <nav className="flex gap-1">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: true }}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

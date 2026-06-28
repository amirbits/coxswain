// The function registry: every capability is a deterministic typed function
// registered exactly once. The command palette, the NL bar, and the agent are
// three front doors onto this same registry (DESIGN.md §5). The LLM never
// executes anything here — it only routes to a registered name with args.

export type RegistryFn = (args: any) => unknown | Promise<unknown>;

export type RegistrySpec = { name: string; description: string };

export class Registry {
  private fns = new Map<string, { fn: RegistryFn; description: string }>();

  register(name: string, description: string, fn: RegistryFn): void {
    this.fns.set(name, { fn, description });
  }

  has(name: string): boolean {
    return this.fns.has(name);
  }

  list(): RegistrySpec[] {
    return [...this.fns.entries()].map(([name, v]) => ({ name, description: v.description }));
  }

  async call(name: string, args: unknown): Promise<unknown> {
    const entry = this.fns.get(name);
    if (!entry) throw new Error(`unknown function: ${name}`);
    return await entry.fn((args ?? {}) as any);
  }
}

/** Common lifecycle boundary for optional transports. */
export interface ApplicationTransport {
  readonly name?: "telegram" | "web";
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class DisabledWebTransport implements ApplicationTransport {
  public readonly name = "web" as const;
  public start(): Promise<void> { return Promise.resolve(); }
  public stop(): Promise<void> { return Promise.resolve(); }
}

export class TransportGroup implements ApplicationTransport {
  public readonly name = "web" as const;
  readonly #transports: readonly ApplicationTransport[];
  public constructor(transports: readonly ApplicationTransport[]) { this.#transports = transports; }
  public async start(): Promise<void> {
    try {
      // Long-lived transports (Telegram polling and WebServer) must start in
      // parallel; awaiting polling first would prevent later listeners from
      // ever being created.
      await Promise.all(this.#transports.map((transport) => transport.start()));
    } catch (error) {
      await Promise.allSettled(this.#transports.map((transport) => transport.stop()));
      throw error;
    }
  }
  public async stop(): Promise<void> { for (const transport of [...this.#transports].reverse()) await transport.stop(); }
}

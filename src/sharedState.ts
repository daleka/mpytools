let selectedPort: string | undefined;

export function setSelectedPort(port: string): void {
  selectedPort = port;
}

export function getSelectedPort(): string | undefined {
  return selectedPort;
}

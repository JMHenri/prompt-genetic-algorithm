export class RequestThrottle {
  private availableRequests: number;
  private readonly maxRequests: number;
  private readonly interval: number;

  constructor(requestsPerMinute: number) {
    this.availableRequests = requestsPerMinute;
    this.maxRequests = requestsPerMinute;
    this.interval = 60000 / requestsPerMinute;

    setInterval(() => {
      this.availableRequests = Math.min(this.availableRequests + 1, this.maxRequests);
    }, this.interval);
  }

  public async acquire(): Promise<void> {
    while (this.availableRequests <= 0) {
      await new Promise(resolve => setTimeout(resolve, this.interval));
    }
    this.availableRequests--;
  }
}
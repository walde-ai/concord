export class CheckRun {
  public constructor(
    public readonly name: string,
    public readonly status: string,
    public readonly conclusion: string | null,
  ) {}
}

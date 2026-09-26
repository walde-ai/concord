export class GithubIssue {
  public constructor(
    public readonly number: number,
    public readonly title: string,
    public readonly url: string,
  ) {}
}

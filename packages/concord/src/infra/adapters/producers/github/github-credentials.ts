export interface GithubCredentials {
  readonly token: string;
}

export interface GithubCredentialsProvider {
  load(): Promise<GithubCredentials>;
}

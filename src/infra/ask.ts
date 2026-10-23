export type Ask = (question: string) => Promise<boolean>;

export class InputClosed extends Error {
  constructor() {
    super('input closed before an answer came');
    this.name = 'InputClosed';
  }
}

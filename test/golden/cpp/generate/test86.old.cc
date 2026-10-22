// [CHOICE] две одинаковые строки в одной функции: строка ниже не различает их, различает строка выше
void Retry() {
  Backoff();
  LogAttempt();
  Backoff();
  Send();
}

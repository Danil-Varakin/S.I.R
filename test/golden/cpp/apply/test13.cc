// [STR] MUST-REFUSE: пробелы внутри строкового литерала — данные: "retry  failed" не находит "retry failed"
void Retry() {
  LOG(ERROR) << "retry failed";
}

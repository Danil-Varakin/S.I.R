// [WS] пробелы вне строк свободны, внутри многострочного R"(…)" схлопываются — якоря с другой разрядкой находят место
const char kHelp[] = R"(
usage:   hatch   apply
)";

void PrintHelp() {
  Print( kHelp );
}

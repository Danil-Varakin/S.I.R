// [RANGE] замена заголовка функции: ( ... ) внутри якоря переживает чужой список аргументов
namespace content {

// Registers every content feature.
void RegisterFeatures(FeatureList* list, bool strict, bool trace) {
  list->Add(kFastPath);
}

}  // namespace content

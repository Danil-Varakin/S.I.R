// [COMMENTBRACE] upstream добавил комментарий со скобками { [ над функциями — скобки в комментарии не структура
// Use the <code>chrome.developerPrivate</code> API to manage extensions.
namespace developerPrivate {
  /* Returns {items} of the profile (see [ItemInfo]). */
  callback ItemsInfoCallback = void (sequence<ItemInfo> result);

  interface Functions {
    // Returns { [items] } — see https://crbug.com/1 (
    static void getExtensionsInfo(optional GetExtensionsInfoOptions options,
                                  ItemsInfoCallback callback);
    static void getProfileConfiguration(ProfileInfoCallback callback);
    static void braveGetExtensionsAllowed(BooleanCallback callback);
  };
};

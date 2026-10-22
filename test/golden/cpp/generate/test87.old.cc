// [CHROMIUM] BASE_FEATURE и IN_PROC_BROWSER_TEST_F: макрос-заголовок перед телом, правка в тесте
#include "base/feature_list.h"
#include "chrome/test/base/in_process_browser_test.h"

namespace features {

BASE_FEATURE(kSidePanel, "SidePanel", base::FEATURE_ENABLED_BY_DEFAULT);
BASE_FEATURE(kTabGroups, "TabGroups", base::FEATURE_DISABLED_BY_DEFAULT);

}  // namespace features

class SidePanelBrowserTest : public InProcessBrowserTest {
 protected:
  base::test::ScopedFeatureList features_;
};

IN_PROC_BROWSER_TEST_F(SidePanelBrowserTest, Opens) {
  ASSERT_TRUE(browser());
  EXPECT_TRUE(base::FeatureList::IsEnabled(features::kSidePanel));
}

IN_PROC_BROWSER_TEST_F(SidePanelBrowserTest, Closes) {
  ASSERT_TRUE(browser());
  EXPECT_TRUE(base::FeatureList::IsEnabled(features::kSidePanel));
}

# SAT 官网操作步骤与实测记录

实测日期：2026-10-22。以下步骤来自已登录官网页面，不代表已验证选座或锁位成功。不得把本次对协议的授权当作以后接受新协议的永久授权。

## 下次操作顺序

1. 打开 `https://mysat.collegeboard.org/dashboard`。需要登录时，按官网提示提交项目设置中保存的邮箱和密码；密码验证页使用 `Verify`。验证码交给用户处理。
2. 登录后等待报名卡片加载。如果目标考期已有 `Incomplete` 报名，打开该考期卡片内的 `Finish Registration`，不要误入其他考期，也不要直接新建另一份报名。
3. 在报名进度页点击 `Select Date and Test Center` 对应的 `Finish`。
4. 如果出现 `Testing Rules`，展示条款并取得用户当次确认。滚动条款内容容器 `#qc-id-termsconditions-scrollbox-termsconditions` 到末尾，等待 `#terms-acceptance-checkbox` 启用，再接受并点击 `#qc-id-termsconditions-button-continue`。不强行启用控件。本次用户已在协议页明确授权接受并继续。
5. 在 `Choose a test date` 核对目标考期。本次页面在 2026 分组下选中 `Dec 5`，控件为 `#qc-id-selectdatecenter-testdate-button-DEC-05`。等考期详情显示 `Saturday, December 5, 2026`，再点击 `#testdate-continue-button`（可访问名称为 `Continue to test location`）。
6. 在 `Choose your test location` 核对完整考期。选择 `Outside the United States`（`#test-location-type-international`），在原生下拉框 `#test-center-country-select` 选择 `Hong Kong`，其值为 `HK`。点击 `#test-center-country-find-button-enabled`（`Find a Test Center`），等待查询结果加载。
7. 按任务目标核对卡片名称、考期和可用时段。显示 `No seats available.` 的目标不点击，不改选其他考点。只允许点击目标卡片内真实存在且可用的时段控件。本次有位时段的 DOM 是 `A` 元素、`role="button"`、文本 `8 a.m.`，实例 ID 为 `qc-id-tc-select-button-1-3025`；该 ID 的数字部分随结果变化，不能固定使用。
8. 选座后记录真实确认页面及返回结果。点击成功、进入后续页面、接口报告有位，都不能单独证明锁位成功。若结果不明，保留浏览器、停止自动推进并交接用户。
9. 付款由用户在官网核对考期、考点、金额后提交。只有官网报名和付款成功，才在本机控制台点击“确认已付款”。

## 本次结果

目标：2026-12-05，Hong Kong，HKEAA - ASIA WORLD EXPO - ZONE A（62250）。

| 考点 | 登录后报名页面 | 旧公开查位接口 |
| --- | --- | --- |
| Zone A（62250） | No seats available. | seatAvailability: true |
| Zone B（62251） | 8 a.m. 可选 | seatAvailability: true |
| HKEAA San Po Kong Office 2nd Floor（62386） | No seats available. | seatAvailability: false |

旧接口为 `https://aru-test-center-search.collegeboard.org/prod/test-centers?date=2026-12-05&country=HK`。在上述官网结果出现后复查，接口仍把 Zone A 报为有位。原因尚未确定，不能以该字段为依据确认目标可选，更不能据此报告锁位成功。

MySAT 首页、考期详情和考点卡片均显示 2026-12-05；中间的报名进度页曾显示 Friday, December 4, 2026。尚未查明该日期显示差异的原因，未更改目标考期。

本次没有点击任何考点时段，没有确认锁位或付款。Zone B 不在任务目标中，因此没有替用户改选。

## 首次实测时的适配缺口（历史记录）

- 首页向导当前优先点击 `Register for the SAT`，需要改为优先查找目标考期的未完成报名。
- 考试规则的复选框在条款内容未滚动到末尾时处于禁用状态，当前实现没有完成这一前置步骤，也没有独立的当次授权交接。
- 日期前进控件通过可访问名称 `Continue to test location` 表达用途，不能只依赖按钮内部文字 `Continue`。
- 国家下拉框的实际 ID 为 `test-center-country-select`，需要匹配真实控件。
- 可选时段使用链接元素，当前只找 `button` / `input` 的选座逻辑会漏掉该控件。
- 锁位成功标志尚无实测证据。目标当前无位，需在目标有位后继续核验。

上述为首次实测后的代码状态。后续适配与验证如下。

## 2026-10-22 后续适配与验证

- 使用项目保存的凭证完成真实登录：邮箱 → 按可访问名称选择 `Select Password.` → 密码 → `Verify`。引擎独立浏览器也验证了自动登录、续办 2026-12-05 报名及到达考试规则页，不需要人工输入凭证。凭证不写入本记录。
- 首页同时存在 2026-11-07 与 2026-12-05 两份未完成报名，新的入口逻辑正确续办了 12 月报名，并点击对应选日期和考点步骤的 `Finish`。
- 用户在本次聊天中明确授权接受当前规则后，完成滚动、勾选及继续。该授权仅适用于当次规则；长期运行的引擎在规则页等待用户当次确认，完成后恢复查位。验证码同样保留浏览器等待处理；暂停任务可终止等待。
- 日期页真实控件为带 `qc-id-selectdatecenter-testdate-button-*` ID 的单选框，年份在外围分组，文本仅显示 `Dec 5`。代码等待异步控件加载，结合年份识别目标，并核对 `December 5, 2026` 后进入考区页。
- 真实页面还包含隐藏的 `Continue` 和 `Find a Test Center` 按钮。日期与查位选择器已排除隐藏控件，避免选中会话弹窗及隐藏的其他考区表单。
- 查位使用已登录报名页面发出的 `/msregadmintestcenter-prod/student/search-test-center-admins` 请求及重新渲染的考点卡片。官网卡片不展示公开查位接口中的考点代码，代码与名称并存时按名称匹配；仅有代码且官网未展示该代码时保守显示未知。
- 真实页面识别结果：Zone A 无位；Zone B 可识别为有可用时段。未点击 Zone B，也未提交选座或付款。

锁位成功标志、照片上传与结账完整流程仍待目标有位时验证；模拟测试通过不等于官网锁位成功。

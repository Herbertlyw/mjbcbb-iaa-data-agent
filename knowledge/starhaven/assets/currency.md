# 金额与汇率

所有金额为Decimal(24,6)，生成与对账使用整数微单位和Decimal，不经float。source_currency_per_usd=1美元兑换原币数；USD=local/rate。XCU是虚构货币，其汇率不是市场报价。逐行换汇再汇总，原始/折后成本分别保留。

除零未知，NULL不补零；显示舍入不改原始六位金额。大规模溢出仍受Decimal(24,6)边界约束。

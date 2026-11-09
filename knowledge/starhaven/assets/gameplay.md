# 玩法、局与模式

第一版只提供局/日聚合，不生成完整游戏引擎、轮块盘面日志。gameplay_seconds是已结束局的秒数；games_started可以大于games_finished。

胜率=games_won/eligible_win_games，无胜负定义时games_won为NULL。复活点击不等于成功看完广告或复活。不同game/模式score_unit不能直接比较。第三款unconfirmed模式不提供胜率。

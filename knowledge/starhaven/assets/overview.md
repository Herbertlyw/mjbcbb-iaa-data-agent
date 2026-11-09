# 业务全景

VV Data Agent 是本项目的应用名称，分析对象为三款完全虚构的手游：拼格（GridFit，game_id=gridfit）、落块（BlockFall，game_id=blockfall）、叠叠乐（StackJoy，game_id=stackjoy）。拼格=拖消，落块=落消，叠叠乐玩法尚未确认。三款各有ios/android包体。先用dim_app确认App，不把game_id、app_id或bundle_id互换。

数据链：投放→安装与归因→设备活跃及cohort→玩法和广告→分来源回收→实验与预测复验。MySQL任务与Redis调度属于控制面，不是这些业务事实。

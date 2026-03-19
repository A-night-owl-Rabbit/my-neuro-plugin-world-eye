// 全部工具的缩略词映射（人工审定）
// 格式: 工具名 → 精炼缩略词（2-10字）

const ABBREVIATION_MAP = {
    // ===== 搜索类 =====
    'vsearch': '语义并发深度搜索',
    'google_search': 'Google搜索',
    'bing_search': 'Bing搜索',
    'duckduckgo_search': 'DuckDuckGo隐私搜索',
    'scholar_search': '学术论文搜索',
    'web_search': 'Tavily快速搜索',

    // ===== B站 =====
    'login_bilibili_by_qrcode': 'B站扫码登录',
    'search_bilibili_video': '搜索B站视频',
    'get_bilibili_video_comprehensive_info': 'B站视频详情/转录',
    'send_bilibili_comment': '发送B站评论',
    'send_bilibili_danmaku': '发送B站弹幕',
    'get_bilibili_ranking': 'B站排行榜',
    'interact_bilibili_video': 'B站点赞/投币/收藏',

    // ===== 小红书 =====
    'xiaohongshu_check_login_status': '小红书登录状态',
    'xiaohongshu_publish_content': '发布小红书图文',
    'xiaohongshu_publish_video': '发布小红书视频',
    'xiaohongshu_search_content': '搜索小红书内容',
    'xiaohongshu_list_feeds': '小红书推荐列表',
    'xiaohongshu_get_post_detail': '小红书帖子详情',
    'xiaohongshu_post_comment': '小红书评论',
    'xiaohongshu_get_user_profile': '小红书用户主页',

    // ===== 媒体/创作 =====
    'generate_image_final': '绘画/生成图片',
    'minimax_music_generate': '生成音乐(带歌词)',
    'minimax_music_generate_instrumental': '生成纯音乐/BGM',
    'minimax_music_config': '配置音乐生成API',
    'minimax_music_status': '查看音乐生成状态',
    'play_random_music': '随机唱歌',
    'stop_music': '停止唱歌',
    'list_music_files': '查看歌曲库',
    'play_specific_music': '唱指定歌曲',
    'play_sound_effect': '播放音效',

    // ===== 视频生成 =====
    'siliconflow_text_to_video': '文生视频',
    'siliconflow_image_to_video': '图生视频',
    'siliconflow_check_video_status': '查询视频生成状态',
    'siliconflow_download_video': '下载视频',

    // ===== 时间/天气 =====
    'get_current_time': '查询时间/日期/星期',
    'greeting_time_auto_check': '问候语时间检查',
    'beichen_weather_reminder': '天气查询',
    'sleep_weather_auto_check': '睡前天气提醒',

    // ===== 代码执行 =====
    'execute_code': '执行Python代码(数据处理/文件/网络/计算)',
    'install_packages': '安装Python包(pip)',

    // ===== 文件操作 =====
    'move_to_folder': '移动文件/目录',
    'rename_file_or_folder': '重命名文件/文件夹',
    'copy_file_or_folder': '复制文件/文件夹',
    'create_directory': '创建目录',
    'create_and_write_txt': '创建/写入TXT文件',
    'search_files_folders': '搜索文件和文件夹',
    'search_and_read_txt_files': '搜索并读取TXT',

    // ===== 浏览器 =====
    'control_edge_browser': '控制Edge浏览器',
    'view_edge_history': '查看浏览历史',

    // ===== 其他 =====
    'launch_application': '启动应用程序',
    'type_text': '模拟键盘打字',
};

module.exports = { ABBREVIATION_MAP };

/**
 * 给正文里的 <img> 补 decoding="async"。
 *
 * 为什么只加 decoding，不加 loading="lazy"
 * ---------------------------------------
 * decoding="async" 只改变「解码跑在哪个线程」—— 图片何时发起请求、何时出现在
 * 视口里都不变，因此对入场动画与滚动观感零影响。
 * 而 loading="lazy" 会推迟请求时机，图片变成滚动到附近才逐张浮现 ——
 * 那属于加载时机的改变，本站明确不加。
 *
 * 覆盖范围限定在文章正文（after_post_render）。主题模板自身的图片
 * （avatar / wallpaper / 预览封面等）不走这条路径，不受影响。
 */

'use strict';

// 属性值里出现 '>' 的概率极低，用非贪婪字符类足够。
const IMG_TAG = /<img\b[^>]*>/gi;

hexo.extend.filter.register('after_post_render', function (data) {
  if (!data.content || data.content.indexOf('<img') === -1) return data;

  data.content = data.content.replace(IMG_TAG, function (tag) {
    if (/\bdecoding\s*=/i.test(tag)) return tag; // 已显式声明就不覆盖

    const selfClosing = /\/\s*>$/.test(tag);
    const body = tag.replace(/\s*\/?>$/, '');
    return body + ' decoding="async"' + (selfClosing ? ' />' : '>');
  });

  return data;
});

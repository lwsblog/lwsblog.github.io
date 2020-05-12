const ap = new APlayer({
    container: document.getElementById('aplayer'),
    fixed: true,
    autoplay: true,
    audio: [
	{
		name: "Summertime",
		artist: 'K-391',
		url: 'http://music.163.com/song/media/outer/url?id=32166628.mp3',
		cover: 'https://cdn.jsdelivr.net/gh/lwsblog/images@master/img/20200512211912.jpg',
	},
	{
		name: "Sunburst",
		artist: 'Tobu,Itro',
		url: 'http://music.163.com/song/media/outer/url?id=28830411.mp3',
		cover: 'https://cdn.jsdelivr.net/gh/lwsblog/images@master/img/20200512212036.jpg',
	},
	{
		name: "Blue Lights",
		artist: 'Fumos',
		url: 'http://music.163.com/song/media/outer/url?id=1376760895.mp3',
		cover: 'https://cdn.jsdelivr.net/gh/lwsblog/images@master/img/20200512212222.jpg',
	},
	{
		name: "Fragments",
		artist: '千坂',
		url: 'http://music.163.com/song/media/outer/url?id=453130276.mp3',
		cover: 'https://cdn.jsdelivr.net/gh/lwsblog/images@master/img/20200512213235.jpg',
	},
	{
		name: "All In",
		artist: 'L3V3LS',
		url: 'http://music.163.com/song/media/outer/url?id=425684642.mp3',
		cover: 'https://cdn.jsdelivr.net/gh/lwsblog/images@master/img/20200512213458.jpg',
	},
]
});
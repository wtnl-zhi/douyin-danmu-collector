import { Cloud } from 'react-icon-cloud'
import type React from 'react'

export type CloudWord = { word: string; count: number; size: number; rotate: number }

type TagCloudProps = { words: CloudWord[] }

const colours = ['#eaf7ff', '#9ed7ff', '#67baff', '#3d9df4', '#c4e7ff', '#70c7ff']

/**
 * A real canvas-based 3D layout. Unlike the previous CSS transform approach,
 * TagCanvas projects and scales every word on each frame, so words crossing
 * the rear hemisphere naturally recede instead of exposing a mirrored face.
 */
export function TagCloud({ words }: TagCloudProps) {
  const tags = words.slice(0, 54)
  const highest = Math.max(...tags.map((item) => item.count), 1)
  const cloudKey = tags.map((item) => `${item.word}:${item.count}`).join('|')

  if (!tags.length) return null

  return <div className="tagcanvas-stage">
    <div className="tagcanvas-halo" aria-hidden="true" />
    <Cloud
      key={cloudKey}
      containerProps={{ className: 'tagcanvas-container' }}
      canvasProps={{ className: 'tagcanvas-canvas', width: 860, height: 860 } as React.HTMLAttributes<HTMLCanvasElement>}
      options={{
        shape: 'sphere',
        initial: [0.7, -0.16],
        maxSpeed: 0.028,
        minSpeed: 0.003,
        decel: 0.97,
        depth: 0.92,
        textColour: '#9ed7ff',
        textFont: '"Noto Sans SC", system-ui, sans-serif',
        textHeight: 16,
        maxBrightness: 1,
        minBrightness: 0.2,
        shadow: '#0a6cc1',
        shadowBlur: 5,
        shadowOffset: [0, 0],
        outlineMethod: 'none',
        padding: 2,
        weight: true,
        weightFrom: 'data-weight',
        weightMode: 'size',
        weightSize: 1,
        weightSizeMin: 14,
        weightSizeMax: 54,
        shuffleTags: true,
        dragControl: true,
        freezeActive: false,
        freezeDecel: true,
        frontSelect: true,
        noSelect: true,
        wheelZoom: false,
        tooltip: 'native',
        radiusX: 1,
        radiusY: 1,
        radiusZ: 1
      }}
    >
      {tags.map((item, index) => {
        const emphasis = item.count / highest
        return <a
          key={item.word}
          href="#word-cloud"
          title={`${item.word}：${item.count} 次`}
          data-weight={item.count}
          onClick={(event) => event.preventDefault()}
          style={{
            color: colours[index % colours.length],
            fontSize: `${Math.round(14 + emphasis * 30)}px`,
            fontWeight: emphasis > 0.62 ? 800 : emphasis > 0.28 ? 700 : 600
          }}
        >{item.word}</a>
      })}
    </Cloud>
    <div className="cloudlegend"><i /><span>Canvas 实时投影 · 拖动旋转</span></div>
  </div>
}

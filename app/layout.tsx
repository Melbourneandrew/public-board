import type {ReactNode} from 'react';
export default function Layout({children}: {children: ReactNode}) {
  return <html lang="en"><body style={{colorScheme:'light dark',fontFamily:'ui-monospace,monospace',margin:0,background:'Canvas',color:'CanvasText'}}>{children}</body></html>;
}

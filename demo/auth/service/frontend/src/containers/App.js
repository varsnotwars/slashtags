import background from './Wallpaper.jpg';
import { useEffect, useReducer } from 'react';
import { initialValue, reducer, StoreContext } from '../store';
import { Website } from './Website';
import { setupRPC } from '../store';

export const App = () => {
  const [store, dispatch] = useReducer(reducer, initialValue);

  useEffect(() => {
    setupRPC(dispatch);
  }, []);

  return (
    <div className="App" style={{ backgroundImage: `url(${background})` }}>
      <StoreContext.Provider value={{ store, dispatch }}>
        <Website />
      </StoreContext.Provider>
    </div>
  );
};

import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import CommentsView from '../components/comments/CommentsView';

export default function Item() {
  const { id } = useParams();
  const numId = Number(id);
  const navigate = useNavigate();

  // Go BACK, don't push "/".
  //
  // `<Link to="/">` sent the reader to `prefs.defaultFeed`, so the tab they came from was lost from
  // all 7 non-default feeds, a `?q=` search context was discarded, and the remembered paging depth
  // went with it (that map is keyed by feed kind, so arriving on a different feed restores nothing:
  // 50 cards at scrollY 3860 became 25 at 0). Browser Back already did the right thing, which is
  // exactly why the in-app control's behaviour was easy to miss.
  //
  // Step back only when there IS an in-app entry to step back to.
  //
  // `window.history.length` is the wrong test and was an outright bug: it counts the whole TAB's
  // session history, so for anyone who opened a shared link after visiting any other site it is
  // already > 1, and "Back to feed" would have navigated them off the app entirely. React Router's
  // `location.key` is 'default' exactly for the entry the app was loaded on, so it distinguishes
  // "you got here by clicking inside the app" from "you landed here" — which is the actual question.
  const location = useLocation();
  const cameFromInApp = location.key !== 'default';
  const goBack = () => {
    if (cameFromInApp) navigate(-1);
    else navigate('/');
  };

  return (
    <main className="disc-main mx-auto max-w-3xl px-3 py-4 sm:px-4">
      <button
        type="button"
        onClick={goBack}
        className="disc-back mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" /> Back to feed
      </button>
      {Number.isFinite(numId) && numId > 0 ? (
        <CommentsView id={numId} />
      ) : (
        <p className="text-muted">Invalid item.</p>
      )}
    </main>
  );
}

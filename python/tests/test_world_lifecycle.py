import asyncio
import threading
import time

import pytest
from firedrill.world import _owned_async


def test_cancelled_resource_creation_disposes_after_event_loop_shutdown():
    created = []
    factory_started = threading.Event()

    class Resource:
        closed = False

        def close(self):
            assert not self.closed
            self.closed = True

    def factory():
        factory_started.set()
        time.sleep(0.1)
        resource = Resource()
        created.append(resource)
        return resource

    async def run():
        pending = asyncio.create_task(_owned_async(factory))
        while not factory_started.is_set():
            await asyncio.sleep(0)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending

    asyncio.run(run())
    assert len(created) == 1
    assert created[0].closed


def test_successful_resource_creation_transfers_ownership_to_caller():
    class Resource:
        closed = False

        def close(self):
            self.closed = True

    resource = asyncio.run(_owned_async(Resource))
    assert not resource.closed
    resource.close()
